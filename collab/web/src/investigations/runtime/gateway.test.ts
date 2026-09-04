import {
  COLLAB_CSRF_HEADER,
  COLLAB_CSRF_HEADER_VALUE,
} from "@cd-collab/contracts/admin";
import {
  CASE_LIST_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_CHANGED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
  INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
  INVESTIGATION_COORDINATION_SCHEMA_ID,
  type CaseV1,
  type ContributionV1,
} from "@cd-collab/contracts/investigation-runtime";
import {
  INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
  INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID,
  parseInvestigationCollectionPage,
  type InvestigationCollectionPageV1,
} from "@cd-collab/contracts/investigation-collection";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_LOST_EVENT } from "../../protected-api.js";
import {
  investigationGateway,
  investigationAnnotationGateway,
  investigationBulkAnnotationGateway,
  investigationCollectionQueryGateway,
  investigationCoordinationGateway,
  investigationWriteGateway,
  parseInvestigationCollectionQueryInput,
  type InvestigationGateway,
  type InvestigationWriteGateway,
} from "./gateway.js";
import {
  ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
  ARTIFACT_ANNOTATION_SCHEMA_ID,
  type ArtifactAnnotationV1,
} from "./annotation-contract.js";
import { createInvestigationGatewayDouble } from "./testkit/gateway-double.js";
import {
  RUNTIME_FIXTURE_IDS,
  RUNTIME_BULK_ANNOTATION_FIXTURE_IDS,
  makeArchiveAllowedLifecycle,
  makeArchiveRefusedLifecycle,
  makeArtifactAnnotationBulkResult,
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

describe("investigation coordination transport", () => {
  const investigationId = RUNTIME_FIXTURE_IDS.populatedCase;
  const actor = { identityId: "identity-alice", username: "alice" } as const;
  const other = { identityId: "identity-bob", username: "bob" } as const;
  const coordination = (revision = 0, coordinator: typeof actor | typeof other | null = null) => ({
    schemaId: INVESTIGATION_COORDINATION_SCHEMA_ID,
    investigationId,
    coordinator,
    revision,
    updatedAt: revision === 0 ? null : "2026-02-03T20:00:00.000Z",
    updatedBy: revision === 0 ? null : other,
    archived: false,
  });
  const coordinationOptions = () => ({
    actorIdentityId: actor.identityId,
    signal: new AbortController().signal,
  });

  it("resolves both optional methods together and leaves legacy gateways unavailable", async () => {
    const legacy = createInvestigationGatewayDouble();
    const resolved = investigationCoordinationGateway(legacy);
    expect(Object.isFrozen(resolved)).toBe(true);
    await expect(resolved.getCoordination(investigationId, coordinationOptions())).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503 },
    });

    const half = {
      ...legacy,
      getCoordination: vi.fn(async () => ({ ok: true, value: coordination() } as const)),
    };
    const allOrNothing = investigationCoordinationGateway(half);
    expect(allOrNothing).toBe(resolved);
    expect(half.getCoordination).not.toHaveBeenCalled();

    const reverseHalf = {
      ...legacy,
      applyCoordinationAction: vi.fn(async () => ({
        ok: false,
        error: { kind: "unexpected" },
      } as const)),
    };
    expect(investigationCoordinationGateway(reverseHalf)).toBe(resolved);
    expect(reverseHalf.applyCoordinationAction).not.toHaveBeenCalled();
  });

  it("GETs a route-bound deeply frozen coordination projection", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(coordination()));
    const result = await investigationGateway.getCoordination(
      investigationId,
      coordinationOptions(),
    );
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/cases/${encodeURIComponent(investigationId)}/coordination`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("POSTs only the strict request and binds route, intent, and actor on success", async () => {
    const success = {
      schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
      investigationId,
      action: "claim_self",
      targetIdentityId: null,
      previousRevision: 0,
      previousCoordinator: null,
      applied: {
        ...coordination(1, actor),
        updatedBy: actor,
      },
    } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(success));
    const input = Object.assign(Object.create({ inherited: "blocked" }), {
      action: "claim_self" as const,
      expectedRevision: 0,
      idempotencyKey: "coord-action-0001",
      clientTime: "2026-02-03T20:00:00.000Z",
      actorIdentityId: "must-not-cross",
      extra: "must-not-cross",
    });
    const result = await investigationGateway.applyCoordinationAction(
      investigationId,
      input,
      coordinationOptions(),
    );
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      schemaId: "cd-collab.investigation_coordination_action_request.v1",
      investigationId,
      action: "claim_self",
      expectedRevision: 0,
      idempotencyKey: "coord-action-0001",
      clientTime: "2026-02-03T20:00:00.000Z",
    });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.applied.coordinator)).toBe(true);
    }

    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...success,
      applied: { ...success.applied, coordinator: other, updatedBy: other },
    }));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      input,
      coordinationOptions(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
      investigationId,
      action: "release_self",
      targetIdentityId: null,
      previousRevision: 1,
      previousCoordinator: actor,
      applied: { ...coordination(2), updatedBy: actor },
    }));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      {
        action: "release_self",
        expectedRevision: 1,
        idempotencyKey: "coord-action-release-0001",
      },
      coordinationOptions(),
    )).resolves.toMatchObject({ ok: true });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
      investigationId,
      action: "assign_participant",
      targetIdentityId: other.identityId,
      previousRevision: 1,
      previousCoordinator: actor,
      applied: { ...coordination(2, other), updatedBy: actor },
    }));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      {
        action: "assign_participant",
        targetIdentityId: other.identityId,
        expectedRevision: 1,
        idempotencyKey: "coord-action-assign-0001",
      },
      coordinationOptions(),
    )).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toMatchObject({
      targetIdentityId: other.identityId,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
      investigationId,
      action: "release_participant",
      targetIdentityId: other.identityId,
      previousRevision: 1,
      previousCoordinator: other,
      applied: { ...coordination(2), updatedBy: actor },
    }));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      {
        action: "release_participant",
        targetIdentityId: other.identityId,
        expectedRevision: 1,
        idempotencyKey: "coord-action-release-participant-0001",
      },
      coordinationOptions(),
    )).resolves.toMatchObject({ ok: true });
  });

  it("strict-parses and context-binds recognized changed/refused conflicts", async () => {
    const changed = {
      schemaId: INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
      error: "coordination_changed",
      investigationId,
      action: "claim_self",
      targetIdentityId: null,
      current: coordination(2),
    } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(changed, 409));
    const result = await investigationGateway.applyCoordinationAction(
      investigationId,
      { action: "claim_self", expectedRevision: 0, idempotencyKey: "coord-action-0002" },
      coordinationOptions(),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "coordination_changed",
        status: 409,
        investigationId,
        action: "claim_self",
        targetIdentityId: null,
        current: changed.current,
      },
    });
    if (!result.ok) expect(Object.isFrozen(result.error)).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
      error: "coordination_refused",
      investigationId,
      action: "claim_self",
      targetIdentityId: null,
      reason: "occupied",
      detail: "Another participant is coordinating this investigation.",
      current: coordination(2, other),
    }, 409));
    const refused = await investigationGateway.applyCoordinationAction(
      investigationId,
      { action: "claim_self", expectedRevision: 2, idempotencyKey: "coord-action-0003" },
      coordinationOptions(),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("coordination_refused");
  });

  it("rejects actor-aware changed/refused contradictions after strict parsing", async () => {
    const input = {
      action: "claim_self" as const,
      expectedRevision: 2,
      idempotencyKey: "coord-action-actor-0001",
    };
    const changedAtExpectedRevision = {
      schemaId: INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
      error: "coordination_changed",
      investigationId,
      action: "claim_self",
      targetIdentityId: null,
      current: coordination(2),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(changedAtExpectedRevision, 409),
    );
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      input,
      coordinationOptions(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });

    const contradictions = [
      {
        schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
        error: "coordination_refused",
        investigationId,
        action: "claim_self",
        targetIdentityId: null,
        reason: "already_coordinator",
        detail: "Already coordinated.",
        current: coordination(2, other),
      },
      {
        schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
        error: "coordination_refused",
        investigationId,
        action: "claim_self",
        targetIdentityId: null,
        reason: "occupied",
        detail: "Occupied.",
        current: coordination(2, actor),
      },
    ] as const;
    for (const contradiction of contradictions) {
      fetchMock.mockResolvedValueOnce(jsonResponse(contradiction, 409));
      await expect(investigationGateway.applyCoordinationAction(
        investigationId,
        input,
        coordinationOptions(),
      )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });
    }

    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_ACTION_REFUSED_SCHEMA_ID,
      error: "coordination_refused",
      investigationId,
      action: "release_self",
      targetIdentityId: null,
      reason: "not_coordinator",
      detail: "Not coordinator.",
      current: coordination(2, actor),
    }, 409));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      {
        action: "release_self",
        expectedRevision: 2,
        idempotencyKey: "coord-action-actor-0002",
      },
      coordinationOptions(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
      error: "coordination_changed",
      investigationId,
      action: "release_self",
      targetIdentityId: null,
      current: coordination(3, other),
    }, 409));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      {
        action: "release_self",
        expectedRevision: 2,
        idempotencyKey: "coord-action-actor-0003",
      },
      coordinationOptions(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COORDINATION_ACTION_SUCCESS_SCHEMA_ID,
      investigationId,
      action: "release_self",
      targetIdentityId: null,
      previousRevision: 2,
      previousCoordinator: other,
      applied: { ...coordination(3), updatedBy: other },
    }));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      {
        action: "release_self",
        expectedRevision: 2,
        idempotencyKey: "coord-action-actor-0004",
      },
      coordinationOptions(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });
  });

  it("gives 401/403 precedence and keeps unknown conflicts and 503 bodies bounded", async () => {
    const misleading = {
      schemaId: INVESTIGATION_COORDINATION_CHANGED_SCHEMA_ID,
      error: "coordination_changed",
      investigationId,
      action: "claim_self",
      targetIdentityId: null,
      current: coordination(2),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const input = {
      action: "claim_self" as const,
      expectedRevision: 0,
      idempotencyKey: "coord-action-0004",
    };
    for (const status of [401, 403] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse(misleading, status));
      await expect(investigationGateway.applyCoordinationAction(
        investigationId,
        input,
        coordinationOptions(),
      )).resolves.toEqual({ ok: false, error: { kind: "auth_lost", status } });
    }

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "something_private", raw: "secret" }, 409));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      input,
      coordinationOptions(),
    )).resolves.toEqual({ ok: false, error: { kind: "conflict", status: 409 } });

    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: "commit_outcome_unknown",
      raw: "must-not-escape",
    }, 503));
    const unknown = await investigationGateway.applyCoordinationAction(
      investigationId,
      input,
      coordinationOptions(),
    );
    expect(unknown).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    });
    expect(JSON.stringify(unknown)).not.toContain("must-not-escape");

    fetchMock.mockResolvedValueOnce(jsonResponse({
      ...misleading,
      raw: "x".repeat(9_000),
    }, 409));
    await expect(investigationGateway.applyCoordinationAction(
      investigationId,
      input,
      coordinationOptions(),
    )).resolves.toEqual({ ok: false, error: { kind: "conflict", status: 409 } });
  });
});

function options(controller = new AbortController()) {
  return { signal: controller.signal };
}

const RUNTIME_BULK_CASE_ID = RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.caseId;

function bulkAnnotationInput() {
  return {
    artifactIds: [
      RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.firstArtifact,
      RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.secondArtifact,
    ],
    body: "A bounded bulk annotation.",
    idempotencyKey: "bulk-runtime-0005",
  };
}

function archivedCase(): CaseV1 {
  return { ...makePopulatedCase(), status: "archived" };
}

/** The one authoritative contribution a create answers with. */
function createdContribution(): ContributionV1 {
  const found = makeContributionList().contributions.find(
    ({ id }) => id === RUNTIME_FIXTURE_IDS.note,
  );
  if (found === undefined) throw new Error("the note contribution fixture is missing");
  return found;
}

function createdHypothesisContribution(): ContributionV1 {
  return {
    ...createdContribution(),
    id: "contribution-linked-hypothesis",
    kind: "hypothesis",
    body: "Evidence points to connection-pool saturation.",
    hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
  };
}

function artifactAnnotation(
  overrides: Partial<ArtifactAnnotationV1> = {},
): ArtifactAnnotationV1 {
  return {
    schemaId: ARTIFACT_ANNOTATION_SCHEMA_ID,
    id: "annotation-001",
    caseId: RUNTIME_FIXTURE_IDS.populatedCase,
    artifactId: RUNTIME_FIXTURE_IDS.evidence,
    body: "The first error appears after the configuration reload.",
    contentHash: "a".repeat(64),
    privacyClass: "share_safe",
    authorId: "identity-lead",
    authorUsername: "lead",
    createdAt: "2026-02-03T20:20:00.000Z",
    sourceId: "source-human-note",
    ...overrides,
  };
}

/** The case a situation update answers with, one version ahead of the fixture. */
function revisedSituationCase(): CaseV1 {
  const current = makePopulatedCase();
  return {
    ...current,
    problemStatement: "Checkout requests exceed the objective after the pool change.",
    situationVersion: current.situationVersion + 1,
  };
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
  it("reads a bounded text evidence preview through the protected gateway", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "first line\nsecond line",
      {
        status: 206,
        headers: {
          "content-type": "text/plain",
          "content-range": "bytes 0-21/22",
          "content-length": "22",
          etag: '"preview-etag"',
        },
      },
    ));
    const result = await investigationGateway.previewEvidence?.(
      RUNTIME_FIXTURE_IDS.populatedCase,
      RUNTIME_FIXTURE_IDS.evidence,
      {},
      options(),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        artifactId: RUNTIME_FIXTURE_IDS.evidence,
        text: "first line\nsecond line",
        truncated: false,
        etag: '"preview-etag"',
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/cases/${encodeURIComponent(RUNTIME_FIXTURE_IDS.populatedCase)}/evidence/${encodeURIComponent(RUNTIME_FIXTURE_IDS.evidence)}/content`,
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      Range: "bytes=0-65535",
    });
  });

  it("rejects binary-looking preview bytes without publishing decoded content", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      new Uint8Array([0, 1, 2]),
      { status: 206, headers: { "content-range": "bytes 0-2/3" } },
    ));
    await expect(investigationGateway.previewEvidence?.(
      RUNTIME_FIXTURE_IDS.populatedCase,
      RUNTIME_FIXTURE_IDS.evidence,
      {},
      options(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "content_type" } });
  });

  it("uses the protected streaming multipart endpoint without base64 buffering", async () => {
    const success = makeEvidenceUploadSuccess();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe(`/api/cases/${encodeURIComponent(RUNTIME_FIXTURE_IDS.populatedCase)}/evidence/stream`);
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(FormData);
      const form = init?.body as FormData;
      expect(form.get("kind")).toBe("log");
      expect(form.get("summary")).toBe("A streamed log");
      const file = form.get("file");
      expect(file).toBeInstanceOf(Blob);
      expect((file as Blob).size).toBeGreaterThan(1_000_000);
      return jsonResponse(success);
    });

    const file = new File([new Uint8Array(1_000_001)], "large.log", { type: "text/plain" });
    const result = await investigationGateway.uploadEvidenceStream!(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "log", summary: "A streamed log", file },
      options(),
    );

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the ten protected routes and publishes only parsed values", async () => {
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
        if (route.endsWith("/contributions") && method === "POST") {
          return jsonResponse(createdContribution());
        }
        if (route.endsWith("/contributions")) return jsonResponse(makeContributionList());
        if (route.endsWith("/situation") && method === "PATCH") {
          return jsonResponse(revisedSituationCase());
        }
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
    const contributionInput = Object.assign(
      Object.create({ inheritedContributionField: "must-not-cross" }) as Record<string, unknown>,
      {
        kind: "hypothesis",
        body: "  Queue time rises immediately after the connection-pool rollout.  ",
        hypothesisLinks: [
          Object.assign(
            Object.create({ inheritedLinkField: "must-not-cross" }) as Record<string, unknown>,
            {
              kind: "artifact",
              id: RUNTIME_FIXTURE_IDS.evidence,
              extraLinkField: "must-not-cross",
            },
          ),
          { kind: "contribution", id: RUNTIME_FIXTURE_IDS.note },
        ],
        privacyClass: "share_safe",
        clientTime: "2026-02-03T19:59:45.000Z",
        sourceId: "source-human-note",
        idempotencyKey: "msg-syn-0001",
        extraContributionField: "must-not-cross",
      },
    );
    const situationInput = Object.assign(
      Object.create({ inheritedSituationField: "must-not-cross" }) as Record<string, unknown>,
      {
        expectedVersion: 4,
        problemStatement: "Checkout requests exceed the objective after the pool change.",
        openQuestions: ["Did the connection-pool change increase queue time?"],
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
        clientTime: "2026-02-03T19:59:50.000Z",
        extraSituationField: "must-not-cross",
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
      investigationGateway.createContribution(
        investigationId,
        contributionInput as unknown as Parameters<
          typeof investigationGateway.createContribution
        >[1],
        signalOptions,
      ),
      investigationGateway.updateSituation(
        investigationId,
        situationInput as unknown as Parameters<
          typeof investigationGateway.updateSituation
        >[1],
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
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(Object.isFrozen(result.value)).toBe(true);
    }
    const listed = results[0];
    const created = results[2];
    const contributions = results[4];
    const uploaded = results[5];
    const contributed = results[6];
    const situation = results[7];
    const lifecycle = results[8];
    const lifecycleAction = results[9];
    expect(listed.ok && Object.isFrozen(listed.value[0])).toBe(true);
    expect(listed.ok && Object.isFrozen(listed.value[1]?.openQuestions)).toBe(true);
    expect(created.ok && Object.isFrozen(created.value.investigationContext)).toBe(true);
    expect(contributions.ok && Object.isFrozen(contributions.value[0])).toBe(true);
    expect(uploaded.ok && Object.isFrozen(uploaded.value.artifact)).toBe(true);
    expect(uploaded.ok && Object.isFrozen(uploaded.value.summary)).toBe(true);
    expect(contributed.ok && contributed.value).toEqual(createdContribution());
    expect(situation.ok && situation.value).toEqual(revisedSituationCase());
    expect(situation.ok && Object.isFrozen(situation.value.openQuestions)).toBe(true);
    if (contributed.ok) {
      expect(() => {
        (contributed.value as { body: string | null }).body = "contaminated";
      }).toThrow();
    }
    if (situation.ok) {
      expect(() => {
        (situation.value as { situationVersion: number }).situationVersion = 99;
      }).toThrow();
    }
    expect(lifecycle.ok && Object.isFrozen(lifecycle.value.deletion.alternatives)).toBe(true);
    expect(lifecycle.ok && Object.isFrozen(lifecycle.value.archive)).toBe(true);
    expect(lifecycle.ok && Object.isFrozen(lifecycle.value.restore)).toBe(true);
    expect(lifecycleAction.ok && Object.isFrozen(lifecycleAction.value.case)).toBe(true);
    if (contributions.ok) {
      expect(() => {
        (contributions.value[0] as { body: string | null }).body = "contaminated";
      }).toThrow();
    }
    if (uploaded.ok) {
      expect(() => {
        (uploaded.value.artifact as { filename: string | null }).filename = "contaminated.log";
      }).toThrow();
      expect(() => {
        (uploaded.value.summary as { body: string | null }).body = "contaminated";
      }).toThrow();
    }
    if (lifecycle.ok) {
      expect(() => {
        (lifecycle.value.deletion.alternatives as string[]).push("delete");
      }).toThrow();
      expect(() => {
        (lifecycle.value.archive as { allowed: boolean }).allowed = false;
      }).toThrow();
    }
    if (lifecycleAction.ok) {
      expect(() => {
        (lifecycleAction.value.case as { title: string }).title = "contaminated";
      }).toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(fetchMock.mock.calls.map(([route, init]) => [String(route), init?.method ?? "GET"]))
      .toEqual([
        ["/api/cases", "GET"],
        [`/api/cases/${investigationId}`, "GET"],
        ["/api/cases", "POST"],
        [`/api/cases/${investigationId}/evidence`, "GET"],
        [`/api/cases/${investigationId}/contributions`, "GET"],
        [`/api/cases/${investigationId}/evidence`, "POST"],
        [`/api/cases/${investigationId}/contributions`, "POST"],
        [`/api/cases/${investigationId}/situation`, "PATCH"],
        [`/api/cases/${investigationId}/lifecycle`, "GET"],
        [`/api/cases/${investigationId}/lifecycle`, "POST"],
      ]);

    const actionInit = fetchMock.mock.calls[9]?.[1];
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

    const contributionInit = fetchMock.mock.calls[6]?.[1];
    expect(JSON.parse(String(contributionInit?.body))).toEqual({
      kind: "hypothesis",
      body: "  Queue time rises immediately after the connection-pool rollout.  ",
      hypothesisLinks: [
        { kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence },
        { kind: "contribution", id: RUNTIME_FIXTURE_IDS.note },
      ],
      privacyClass: "share_safe",
      clientTime: "2026-02-03T19:59:45.000Z",
      sourceId: "source-human-note",
      idempotencyKey: "msg-syn-0001",
    });

    const situationInit = fetchMock.mock.calls[7]?.[1];
    expect(JSON.parse(String(situationInit?.body))).toEqual({
      expectedVersion: 4,
      problemStatement: "Checkout requests exceed the objective after the pool change.",
      openQuestions: ["Did the connection-pool change increase queue time?"],
      investigationContext: {
        productName: "ContextDesk Storefront",
        version: "4.8.0",
        build: "2026.02.03.4",
        component: "checkout-api",
        environment: "production",
        organization: "Retail operations",
      },
      clientTime: "2026-02-03T19:59:50.000Z",
    });

    for (const callIndex of [2, 5, 6, 7, 9]) {
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

describe("upload commit-outcome-unknown 503 parsing", () => {
  const uploadInput = { kind: "log" as const, summary: "Synthetic" };

  it("preserves only the bounded unknown-outcome discriminant for the exact 503 body", async () => {
    const response = jsonResponse({ error: "commit_outcome_unknown" }, 503);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(),
    );

    expect(result).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(Object.keys((result as { error: object }).error).sort()).toEqual(["kind", "reason", "status"]);
  });

  it("recognizes the exact bounded code split across non-empty chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ error: "commit_outcome_unknown" }));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(bytes.slice(0, 9));
        stream.enqueue(bytes.slice(9));
        stream.close();
      },
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(),
    )).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    });
  });

  it.each([401, 403] as const)(
    "classifies %i as auth loss before a misleading commit-outcome-unknown body",
    async (status) => {
      const response = jsonResponse({ error: "commit_outcome_unknown" }, status);
      const json = vi.spyOn(response, "json");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const listener = vi.fn();
      window.addEventListener(AUTH_LOST_EVENT, listener);
      try {
        const result = await investigationGateway.uploadEvidence(
          RUNTIME_FIXTURE_IDS.populatedCase,
          uploadInput,
          options(),
        );
        expect(result).toEqual({ ok: false, error: { kind: "auth_lost", status } });
        expect(json).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener(AUTH_LOST_EVENT, listener);
      }
    },
  );

  it("treats malformed, non-JSON, and other 503 bodies as generic unavailable", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response("not json", {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 503 }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "storage_unavailable" }, 503));
    fetchMock.mockResolvedValueOnce(jsonResponse({ private: "must-not-escape" }, 503));
    const unavailable = { ok: false, error: { kind: "unavailable", status: 503 } };

    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(),
    )).toEqual(unavailable);
    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(),
    )).toEqual(unavailable);
    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(),
    )).toEqual(unavailable);
    const other = await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(),
    );
    expect(other).toEqual(unavailable);
    expect(JSON.stringify(other)).not.toContain("must-not-escape");
  });

  it("cancels and rejects an oversized chunked 503 body without retaining it", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(700));
        stream.enqueue(new Uint8Array(400));
      },
      cancel: cancelled,
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(),
    )).toEqual({ ok: false, error: { kind: "unavailable", status: 503 } });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("promptly cancels a stalled body read when the caller aborts", async () => {
    const controller = new AbortController();
    const readStarted = createDeferred<void>();
    const reader = {
      read: vi.fn(() => {
        readStarted.resolve();
        return new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined);
      }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: false,
      status: 503,
      headers: new Headers({ "content-type": "application/json" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const pending = investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(controller),
    );
    await readStarted.promise;
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted" } });
    expect(reader.cancel).toHaveBeenCalledTimes(1);
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not read an upload failure body when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(controller),
    )).toEqual({ ok: false, error: { kind: "aborted" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks abort again after the bounded body has been read", async () => {
    const controller = new AbortController();
    const bytes = new TextEncoder().encode(JSON.stringify({ error: "commit_outcome_unknown" }));
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: bytes })
        .mockResolvedValueOnce({ done: true, value: undefined }),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(() => controller.abort()),
    };
    const response = {
      ok: false,
      status: 503,
      headers: new Headers({ "content-type": "application/json" }),
      body: { getReader: () => reader },
    } as unknown as Response;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    expect(await investigationGateway.uploadEvidence(
      RUNTIME_FIXTURE_IDS.populatedCase,
      uploadInput,
      options(controller),
    )).toEqual({ ok: false, error: { kind: "aborted" } });
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
    if (result.ok || result.error.kind !== "lifecycle_changed") {
      throw new Error("expected a lifecycle-changed conflict");
    }
    const current = result.error.current;
    expect(Object.isFrozen(current)).toBe(true);
    expect(Object.isFrozen(current.archive)).toBe(true);
    expect(Object.isFrozen(current.restore)).toBe(true);
    expect(() => {
      (current as { legalHold: boolean }).legalHold = true;
    }).toThrow();
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

describe("Runtime V1.1 write seams", () => {
  it("keeps an unlinked note request backward-compatible on the wire", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(createdContribution()),
    );

    await expect(investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        kind: "note",
        body: "An unlinked note remains a bounded note.",
        privacyClass: "share_safe",
        clientTime: "2026-02-03T19:59:45.000Z",
        sourceId: "source-human-note",
      },
      options(),
    )).resolves.toEqual({ ok: true, value: createdContribution() });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "note",
      body: "An unlinked note remains a bounded note.",
      privacyClass: "share_safe",
      clientTime: "2026-02-03T19:59:45.000Z",
      sourceId: "source-human-note",
    });
  });

  it("serializes a bounded evidence-link snapshot without rewriting the body", async () => {
    const deferred = createDeferred<Response>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => deferred.promise);
    const link = {
      kind: "artifact" as const,
      id: RUNTIME_FIXTURE_IDS.evidence as string,
      privateAnnotation: "must-not-cross",
    };
    const pending = investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        kind: "hypothesis",
        body: "  Evidence points to connection-pool saturation.  ",
        hypothesisLinks: [link],
        idempotencyKey: "msg-syn-0002",
      },
      options(),
    );
    link.id = "mutated-after-request";

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "hypothesis",
      body: "  Evidence points to connection-pool saturation.  ",
      hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
      idempotencyKey: "msg-syn-0002",
    });
    const created = createdHypothesisContribution();
    deferred.resolve(jsonResponse(created));
    await expect(pending).resolves.toEqual({ ok: true, value: created });
    expect(created.hypothesisLinks).toEqual([
      { kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence },
    ]);
  });

  it.each([
    ["a non-array collection", { hypothesisLinks: "artifact" }],
    ["an invalid link kind", { hypothesisLinks: [{ kind: "case", id: "case-a" }] }],
    ["a non-string link identity", { hypothesisLinks: [{ kind: "artifact", id: 7 }] }],
    ["a null link", { hypothesisLinks: [null] }],
  ])("rejects %s before fetching", async (_label, malformed) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const result = await investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        kind: "hypothesis",
        body: "Malformed links must not cross transport.",
        ...malformed,
      } as never,
      options(),
    );

    expect(result).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["message", "note", "action", "upload", "external_run"] as const)(
    "rejects hypothesis links on a %s contribution before fetching",
    async (kind) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");

      const result = await investigationGateway.createContribution(
        RUNTIME_FIXTURE_IDS.populatedCase,
        {
          kind,
          body: "Links must remain hypothesis-only.",
          hypothesisLinks: [{ kind: "artifact", id: RUNTIME_FIXTURE_IDS.evidence }],
        },
        options(),
      );

      expect(result).toEqual({ ok: false, error: { kind: "unexpected" } });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("sends only supplied situation fields and keeps an explicit context erasure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(revisedSituationCase()));

    await investigationGateway.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 0, impact: "", investigationContext: null },
      options(),
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      expectedVersion: 0,
      impact: "",
      investigationContext: null,
    });
  });

  it("URL-encodes the contribution and situation routes instead of interpolating text", async () => {
    const investigationId = "case /?# owned";
    const contribution = { ...createdContribution(), caseId: investigationId };
    const investigation = { ...revisedSituationCase(), id: investigationId };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse(contribution));
    fetchMock.mockResolvedValueOnce(jsonResponse(investigation));

    expect(await investigationGateway.createContribution(
      investigationId,
      { kind: "note", body: "Synthetic" },
      options(),
    )).toEqual({ ok: true, value: contribution });
    expect(await investigationGateway.updateSituation(
      investigationId,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    )).toEqual({ ok: true, value: investigation });
    expect(fetchMock.mock.calls.map(([route]) => String(route))).toEqual([
      "/api/cases/case%20%2F%3F%23%20owned/contributions",
      "/api/cases/case%20%2F%3F%23%20owned/situation",
    ]);
  });

  it("rejects a contribution or case answered for another case or without identity", async () => {
    const other = "case-other";
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...createdContribution(), caseId: other }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...createdContribution(), id: "" }));
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...revisedSituationCase(), id: other }));
    const identityFailure = { ok: false, error: { kind: "protocol", reason: "identity" } };

    for (const _attempt of [0, 1]) {
      expect(await investigationGateway.createContribution(
        RUNTIME_FIXTURE_IDS.populatedCase,
        { kind: "note", body: "Synthetic" },
        options(),
      )).toEqual(identityFailure);
    }
    expect(await investigationGateway.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    )).toEqual(identityFailure);
  });

  it("reports a stale expectedVersion as a bounded conflict without reading the body", async () => {
    const response = jsonResponse(
      { error: "situation_conflict", currentVersion: 9, private: "must-not-escape" },
      409,
    );
    const json = vi.spyOn(response, "json");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    const result = await investigationGateway.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    );

    expect(result).toEqual({ ok: false, error: { kind: "conflict", status: 409 } });
    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
  });

  it.each([401, 403] as const)(
    "preserves protectedApiFetch auth loss for %i on both write seams",
    async (status) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      fetchMock.mockResolvedValue(jsonResponse({ error: "forbidden" }, status));
      const listener = vi.fn();
      window.addEventListener(AUTH_LOST_EVENT, listener);
      try {
        expect(await investigationGateway.createContribution(
          RUNTIME_FIXTURE_IDS.populatedCase,
          { kind: "note", body: "Synthetic" },
          options(),
        )).toEqual({ ok: false, error: { kind: "auth_lost", status } });
        expect(await investigationGateway.updateSituation(
          RUNTIME_FIXTURE_IDS.populatedCase,
          { expectedVersion: 4, impact: "Synthetic" },
          options(),
        )).toEqual({ ok: false, error: { kind: "auth_lost", status } });
        expect(listener).toHaveBeenCalledTimes(2);
      } finally {
        window.removeEventListener(AUTH_LOST_EVENT, listener);
      }
    },
  );

  it("does not fetch either write when the caller's signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "note", body: "Synthetic" },
      options(controller),
    )).toEqual({ ok: false, error: { kind: "aborted" } });
    expect(await investigationGateway.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(controller),
    )).toEqual({ ok: false, error: { kind: "aborted" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not publish a write answered after cancellation", async () => {
    const controller = new AbortController();
    const deferred = createDeferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(() => deferred.promise);

    const pending = investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "note", body: "Synthetic" },
      options(controller),
    );
    controller.abort();
    deferred.resolve(jsonResponse(createdContribution()));

    expect(await pending).toEqual({ ok: false, error: { kind: "aborted" } });
  });

  it("contains write-body getter failures without fetching or publishing detail", async () => {
    const secret = "private situation detail";
    const contributionInput = {} as Record<string, unknown>;
    Object.defineProperty(contributionInput, "kind", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const linkedContributionInput = {
      kind: "hypothesis",
      body: "Hostile nested input",
      hypothesisLinks: [{ kind: "artifact" }],
    } as Record<string, unknown>;
    Object.defineProperty(
      (linkedContributionInput.hypothesisLinks as Record<string, unknown>[])[0],
      "id",
      {
        enumerable: true,
        get: () => {
          throw new Error(secret);
        },
      },
    );
    const situationInput = { expectedVersion: 4 } as Record<string, unknown>;
    Object.defineProperty(situationInput, "impact", {
      enumerable: true,
      get: () => {
        throw new Error(secret);
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const contribution = await investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      contributionInput as unknown as Parameters<
        typeof investigationGateway.createContribution
      >[1],
      options(),
    );
    const situation = await investigationGateway.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      situationInput as unknown as Parameters<typeof investigationGateway.updateSituation>[1],
      options(),
    );
    const linkedContribution = await investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      linkedContributionInput as unknown as Parameters<
        typeof investigationGateway.createContribution
      >[1],
      options(),
    );

    expect(contribution).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(situation).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(linkedContribution).toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(JSON.stringify([contribution, situation, linkedContribution])).not.toContain(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a write answered with a broken contract or the wrong media type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...createdContribution(), revision: -1 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(revisedSituationCase())));

    expect(await investigationGateway.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "note", body: "Synthetic" },
      options(),
    )).toEqual({ ok: false, error: { kind: "protocol", reason: "contract" } });
    expect(await investigationGateway.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    )).toEqual({ ok: false, error: { kind: "protocol", reason: "content_type" } });
  });
});

describe("artifact annotation runtime seam", () => {
  it("reads a frozen, case-scoped annotation collection", async () => {
    const annotation = artifactAnnotation();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
        caseId: RUNTIME_FIXTURE_IDS.populatedCase,
        annotations: [annotation],
      }),
    );

    const result = await investigationGateway.listArtifactAnnotations!(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    );

    expect(result).toEqual({ ok: true, value: [annotation] });
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value[0])).toBe(true);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/cases/${RUNTIME_FIXTURE_IDS.populatedCase}/evidence/annotations`,
    );
  });

  it.each([
    ["wrong list schema", {
      schemaId: "cd-collab.future_annotations.v9",
      caseId: RUNTIME_FIXTURE_IDS.populatedCase,
      annotations: [],
    }],
    ["unknown annotation member", {
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: RUNTIME_FIXTURE_IDS.populatedCase,
      annotations: [{ ...artifactAnnotation(), privateNote: "must not cross" }],
    }],
    ["row bound to another case", {
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: RUNTIME_FIXTURE_IDS.populatedCase,
      annotations: [artifactAnnotation({ caseId: "case-other" })],
    }],
  ] as const)("rejects %s before exposing annotation data", async (_label, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));

    await expect(investigationGateway.listArtifactAnnotations!(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "contract" } });
  });

  it("rejects duplicate annotation identities after parsing", async () => {
    const annotation = artifactAnnotation();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      schemaId: ARTIFACT_ANNOTATION_LIST_SCHEMA_ID,
      caseId: RUNTIME_FIXTURE_IDS.populatedCase,
      annotations: [annotation, annotation],
    }));

    await expect(investigationGateway.listArtifactAnnotations!(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).resolves.toEqual({ ok: false, error: { kind: "protocol", reason: "identity" } });
  });

  it("creates an annotation through the protected artifact route", async () => {
    const created = artifactAnnotation({
      id: "annotation-created",
      body: "The request id appears in the gateway log.",
      privacyClass: "owner_only",
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(created),
    );

    await expect(investigationGateway.createArtifactAnnotation!(
      RUNTIME_FIXTURE_IDS.populatedCase,
      RUNTIME_FIXTURE_IDS.evidence,
      {
        body: "The request id appears in the gateway log.",
        privacyClass: "owner_only",
        clientTime: "2026-02-03T20:21:00.000Z",
        sourceId: "source-human-note",
        idempotencyKey: "annotation-runtime-1",
      },
      options(),
    )).resolves.toEqual({ ok: true, value: created });

    const [route, init] = fetchMock.mock.calls[0] ?? [];
    expect(route).toBe(
      `/api/cases/${RUNTIME_FIXTURE_IDS.populatedCase}/evidence/${RUNTIME_FIXTURE_IDS.evidence}/annotations`,
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "content-type": "application/json",
      "x-cd-collab-csrf": "1",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      body: "The request id appears in the gateway log.",
      privacyClass: "owner_only",
      clientTime: "2026-02-03T20:21:00.000Z",
      sourceId: "source-human-note",
      idempotencyKey: "annotation-runtime-1",
    });
  });

  it("creates a target set with exactly one protected bulk POST", async () => {
    const bulk = makeArtifactAnnotationBulkResult();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(bulk));
    const artifactIds = bulk.items.map((item) => item.artifactId);
    const result = await investigationGateway.createArtifactAnnotationsBulk!(
      bulk.caseId,
      {
        artifactIds,
        body: "The selected files share a timeout window.",
        privacyClass: "share_safe",
        clientTime: "2026-09-04T10:00:00.000Z",
        idempotencyKey: "bulk-runtime-0001",
      },
      options(),
    );
    expect(result).toEqual({ ok: true, value: bulk });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.items)).toBe(true);
      expect(Object.isFrozen(result.value.items[0])).toBe(true);
      expect(
        result.value.items[0]?.outcome === "not_found"
          || Object.isFrozen(result.value.items[0]?.annotation),
      ).toBe(true);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [route, init] = fetchMock.mock.calls[0] ?? [];
    expect(route).toBe(`/api/cases/${bulk.caseId}/evidence/annotations`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      schemaId: ARTIFACT_ANNOTATION_BULK_REQUEST_SCHEMA_ID,
      artifactIds,
      body: "The selected files share a timeout window.",
      privacyClass: "share_safe",
      clientTime: "2026-09-04T10:00:00.000Z",
      idempotencyKey: "bulk-runtime-0001",
    });
  });

  it.each([
    ["wrong case", { caseId: "40000000-0000-4000-8000-000000000001" }, "contract"],
    ["omitted target", { items: [makeArtifactAnnotationBulkResult().items[0]] }, "identity"],
    ["duplicate target", {
      items: [
        makeArtifactAnnotationBulkResult().items[0],
        makeArtifactAnnotationBulkResult().items[0],
      ],
    }, "contract"],
    ["annotation bound to another target", {
      items: [{
        ...makeArtifactAnnotationBulkResult().items[0]!,
        annotation: {
          ...(makeArtifactAnnotationBulkResult().items[0] as { annotation: object }).annotation,
          artifactId: "10000000-0000-4000-8000-000000000099",
        },
      }, makeArtifactAnnotationBulkResult().items[1]],
    }, "contract"],
  ] as const)("rejects a bulk acknowledgement with %s", async (_label, overrides, reason) => {
    const body = { ...makeArtifactAnnotationBulkResult(), ...overrides };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));
    await expect(investigationGateway.createArtifactAnnotationsBulk!(
      makeArtifactAnnotationBulkResult().caseId,
      {
        artifactIds: makeArtifactAnnotationBulkResult().items.map((item) => item.artifactId),
        body: "Bulk identity test",
        idempotencyKey: "bulk-runtime-0002",
      },
      options(),
    )).resolves.toEqual({
      ok: false,
      error: { kind: "protocol", reason },
    });
  });

  it("classifies a bulk replayable unknown commit without exposing its body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "commit_outcome_unknown", private: "must-not-escape" }, 503),
    );
    await expect(investigationGateway.createArtifactAnnotationsBulk!(
      makeArtifactAnnotationBulkResult().caseId,
      {
        artifactIds: makeArtifactAnnotationBulkResult().items.map((item) => item.artifactId),
        body: "Unknown bulk commit",
        idempotencyKey: "bulk-runtime-0003",
      },
      options(),
    )).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    });
  });

  it.each([401, 403] as const)(
    "preserves protected auth-loss semantics for bulk annotation writes (%i)",
    async (status) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ error: "forbidden" }, status),
      );
      const listener = vi.fn();
      window.addEventListener(AUTH_LOST_EVENT, listener);
      try {
        await expect(investigationGateway.createArtifactAnnotationsBulk!(
          RUNTIME_BULK_CASE_ID,
          bulkAnnotationInput(),
          options(),
        )).resolves.toEqual({ ok: false, error: { kind: "auth_lost", status } });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener(AUTH_LOST_EVENT, listener);
      }
    },
  );

  it("keeps a bulk annotation conflict bounded", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "idempotency_conflict", private: "must-not-escape" }, 409),
    );
    await expect(investigationGateway.createArtifactAnnotationsBulk!(
      RUNTIME_BULK_CASE_ID,
      bulkAnnotationInput(),
      options(),
    )).resolves.toEqual({ ok: false, error: { kind: "conflict", status: 409 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an annotation commit-outcome-unknown response without exposing its body", async () => {
    const response = jsonResponse({ error: "commit_outcome_unknown", private: "must-not-escape" }, 503);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(investigationGateway.createArtifactAnnotation!(
      RUNTIME_FIXTURE_IDS.populatedCase,
      RUNTIME_FIXTURE_IDS.evidence,
      { body: "Synthetic annotation", idempotencyKey: "annotation-unknown-1" },
      options(),
    )).resolves.toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503, reason: "commit_outcome_unknown" },
    });
  });

  it.each([401, 403] as const)(
    "preserves protected auth-loss semantics for annotation reads and writes (%i)",
    async (status) => {
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        jsonResponse({ error: "forbidden" }, status),
      );
      const listener = vi.fn();
      window.addEventListener(AUTH_LOST_EVENT, listener);
      try {
        await expect(investigationGateway.listArtifactAnnotations!(
          RUNTIME_FIXTURE_IDS.populatedCase,
          options(),
        )).resolves.toEqual({ ok: false, error: { kind: "auth_lost", status } });
        await expect(investigationGateway.createArtifactAnnotation!(
          RUNTIME_FIXTURE_IDS.populatedCase,
          RUNTIME_FIXTURE_IDS.evidence,
          { body: "Synthetic" },
          options(),
        )).resolves.toEqual({ ok: false, error: { kind: "auth_lost", status } });
        expect(listener).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        window.removeEventListener(AUTH_LOST_EVENT, listener);
      }
    },
  );

  it("resolves both annotation methods together and fails a partial gateway closed", async () => {
    const partial = {
      listArtifactAnnotations: investigationGateway.listArtifactAnnotations,
    } as InvestigationGateway;
    const resolved = investigationAnnotationGateway(partial);
    expect(await resolved.listArtifactAnnotations(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual({ ok: false, error: { kind: "unavailable", status: 503 } });
  });

  it("fails the optional bulk method closed for a pre-bulk double", async () => {
    const resolved = investigationBulkAnnotationGateway(
      createInvestigationGatewayDouble(),
    );
    expect(await resolved.createArtifactAnnotationsBulk(
      RUNTIME_FIXTURE_IDS.populatedCase,
      {
        artifactIds: [RUNTIME_FIXTURE_IDS.evidence],
        body: "Bulk method is not installed.",
        idempotencyKey: "bulk-runtime-0004",
      },
      options(),
    )).toEqual({ ok: false, error: { kind: "unavailable", status: 503 } });
  });
});

describe("write-seam resolution", () => {
  it("resolves the concrete production seams and keeps the read contract intact", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse(createdContribution()));
    fetchMock.mockResolvedValueOnce(jsonResponse(revisedSituationCase()));
    const writes = investigationWriteGateway(investigationGateway);

    expect(await writes.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "note", body: "Synthetic" },
      options(),
    )).toEqual({ ok: true, value: createdContribution() });
    expect(await writes.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    )).toEqual({ ok: true, value: revisedSituationCase() });
    expect(fetchMock.mock.calls.map(([route, init]) => [String(route), init?.method])).toEqual([
      [`/api/cases/${RUNTIME_FIXTURE_IDS.populatedCase}/contributions`, "POST"],
      [`/api/cases/${RUNTIME_FIXTURE_IDS.populatedCase}/situation`, "PATCH"],
    ]);
  });

  it("keeps an existing read-shaped gateway valid and fails its writes closed", async () => {
    // Model a pre-V1.1 consumer explicitly: the shared test double now
    // exposes both optional seams, while an older read-only transport does not.
    const {
      createContribution: _createContribution,
      updateSituation: _updateSituation,
      ...readOnlyDouble
    } = createInvestigationGatewayDouble();
    expect(readOnlyDouble).not.toHaveProperty("createContribution");
    expect(readOnlyDouble).not.toHaveProperty("updateSituation");
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const writes = investigationWriteGateway(readOnlyDouble);
    const unavailable = { ok: false, error: { kind: "unavailable", status: 503 } };
    expect(await writes.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "note", body: "Synthetic" },
      options(),
    )).toEqual(unavailable);
    expect(await writes.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    )).toEqual(unavailable);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readOnlyDouble.listContributions(
      RUNTIME_FIXTURE_IDS.populatedCase,
      options(),
    )).toEqual({ ok: true, value: makeContributionList().contributions });
  });

  it("fails both seams closed when a transport implements only one of them", async () => {
    const {
      updateSituation: _updateSituation,
      ...readOnlyTransport
    } = createInvestigationGatewayDouble();
    const createContribution = vi.fn();
    const halfImplemented: InvestigationGateway = {
      ...readOnlyTransport,
      createContribution,
    };

    const writes = investigationWriteGateway(halfImplemented);
    const unavailable = { ok: false, error: { kind: "unavailable", status: 503 } };
    expect(await writes.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "note", body: "Synthetic" },
      options(),
    )).toEqual(unavailable);
    expect(await writes.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    )).toEqual(unavailable);
    expect(createContribution).not.toHaveBeenCalled();
  });

  it("delegates on the owning gateway so a stateful transport keeps its receiver", async () => {
    const contribution = createdContribution();
    const investigation = revisedSituationCase();
    const receivers: unknown[] = [];
    const stateful: InvestigationGateway = {
      ...createInvestigationGatewayDouble(),
      createContribution(this: InvestigationGateway) {
        receivers.push(this);
        return Promise.resolve({ ok: true as const, value: contribution });
      },
      updateSituation(this: InvestigationGateway) {
        receivers.push(this);
        return Promise.resolve({ ok: true as const, value: investigation });
      },
    };

    const writes: InvestigationWriteGateway = investigationWriteGateway(stateful);
    await writes.createContribution(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { kind: "note", body: "Synthetic" },
      options(),
    );
    await writes.updateSituation(
      RUNTIME_FIXTURE_IDS.populatedCase,
      { expectedVersion: 4, impact: "Synthetic" },
      options(),
    );

    expect(receivers).toEqual([stateful, stateful]);
    expect(Object.isFrozen(writes)).toBe(true);
  });
});

const OPAQUE_COLLECTION_CURSOR = "eyJzZXJ2ZXJPd25lZCI6dHJ1ZX0";
const COLLECTION_IMPACT_IDENTITY = {
  productName: "Fixture Desk",
  version: "4.2",
  build: "",
  component: "queue-worker",
  environment: "",
};

function emptyCollectionFacets() {
  return {
    status: { top: [] as Array<{ key: string; count: number }>, otherCount: 0 },
    entity: { top: [] as Array<{ key: string; count: number }>, otherCount: 0 },
    impactIdentity: { top: [] as Array<{ key: string; count: number; identity: typeof COLLECTION_IMPACT_IDENTITY }>, otherCount: 0 },
    contributor: { top: [] as Array<{ key: string; count: number }>, otherCount: 0 },
  };
}

function collectionPageJson(
  overrides: Record<string, unknown> = {},
): InvestigationCollectionPageV1 {
  return parseInvestigationCollectionPage({
    schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
    items: makeCaseList().cases,
    nextCursor: null,
    hiddenArchivedCount: 0,
    facets: emptyCollectionFacets(),
    ...overrides,
  });
}

describe("collection query seam", () => {
  it("serializes only approved filters and the schema opt-in", async () => {
    const page = collectionPageJson();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(page));
    const input = Object.assign(
      Object.create({ inheritedFilter: "must-not-cross" }) as Record<string, unknown>,
      {
        q: "  storefront operators  ",
        status: ["open", "monitoring"],
        includeArchived: true,
        entityId: "ent-northwind",
        impactIdentity: Object.assign(
          Object.create({ inheritedIdentity: "must-not-cross" }) as Record<string, unknown>,
          { ...COLLECTION_IMPACT_IDENTITY, extraIdentityField: "must-not-cross" },
        ),
        contributorId: "identity-alice",
        recordedFrom: "2026-01-01T00:00:00.000Z",
        recordedTo: "2026-08-26T00:00:00.000Z",
        cursor: OPAQUE_COLLECTION_CURSOR,
        limit: 25,
        sort: "urgency",
        urgency: "high",
        completeness: 1,
        hiddenArchivedCount: 9,
      },
    );

    const result = await investigationGateway.queryInvestigations(
      input as Parameters<typeof investigationGateway.queryInvestigations>[0],
      options(),
    );

    expect(result).toEqual({ ok: true, value: page });
    expect(result.ok && Object.isFrozen(result.value)).toBe(true);
    expect(result.ok && Object.isFrozen(result.value.items)).toBe(true);
    expect(result.ok && Object.isFrozen(result.value.facets)).toBe(true);
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    const url = new URL(requested, "http://runtime.test");
    expect(url.pathname).toBe("/api/cases");
    expect(url.searchParams.get("schemaId")).toBe(INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID);
    expect(url.searchParams.get("q")).toBe("storefront operators");
    expect(url.searchParams.getAll("status")).toEqual(["open", "monitoring"]);
    expect(url.searchParams.get("includeArchived")).toBe("true");
    expect(url.searchParams.get("entityId")).toBe("ent-northwind");
    expect(JSON.parse(url.searchParams.get("impactIdentity") ?? "null")).toEqual(
      COLLECTION_IMPACT_IDENTITY,
    );
    expect(url.searchParams.get("contributorId")).toBe("identity-alice");
    expect(url.searchParams.get("recordedFrom")).toBe("2026-01-01T00:00:00.000Z");
    expect(url.searchParams.get("recordedTo")).toBe("2026-08-26T00:00:00.000Z");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe(OPAQUE_COLLECTION_CURSOR);
    expect(url.searchParams.get("sort")).toBeNull();
    expect(url.searchParams.get("urgency")).toBeNull();
    expect(url.searchParams.get("completeness")).toBeNull();
    expect(url.searchParams.get("hiddenArchivedCount")).toBeNull();
    expect(url.searchParams.get("inheritedFilter")).toBeNull();
  });

  it("opts a default query in with schemaId and does not call the legacy list parser", async () => {
    const page = collectionPageJson({ items: [], hiddenArchivedCount: 0 });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(page));

    const result = await investigationGateway.queryInvestigations({}, options());

    expect(result).toEqual({ ok: true, value: page });
    const requested = String(fetchMock.mock.calls[0]?.[0]);
    const url = new URL(requested, "http://runtime.test");
    expect(url.pathname).toBe("/api/cases");
    expect([...url.searchParams.keys()]).toEqual(["schemaId"]);
    expect(url.searchParams.get("schemaId")).toBe(INVESTIGATION_COLLECTION_QUERY_SCHEMA_ID);
    expect(result.ok && result.value.facets.status.top).toEqual([]);
    expect(result.ok && result.value.hiddenArchivedCount).toBe(0);
  });

  it("keeps listInvestigations on the unpaged envelope and does not invent a page", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(makeCaseList()));
    const listed = await investigationGateway.listInvestigations(options());
    expect(listed).toEqual({ ok: true, value: makeCaseList().cases });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/cases");
  });

  it("rejects a malformed page through the contract and does not fall back to the list", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse(makeCaseList()));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      schemaId: INVESTIGATION_COLLECTION_PAGE_SCHEMA_ID,
      items: makeCaseList().cases,
      nextCursor: null,
      hiddenArchivedCount: 0,
    }));

    expect(await investigationGateway.queryInvestigations({ q: "checkout" }, options())).toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });
    expect(await investigationGateway.queryInvestigations({ q: "checkout" }, options())).toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fetch when the query itself fails the contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await investigationGateway.queryInvestigations({ limit: 101 }, options())).toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });
    expect(parseInvestigationCollectionQueryInput({ q: "checkout", limit: 101 })).toEqual({
      ok: false,
      error: { kind: "protocol", reason: "contract" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403] as const)(
    "classifies collection-query auth loss for %i without reading the body",
    async (status) => {
      const response = jsonResponse(collectionPageJson(), status);
      const json = vi.spyOn(response, "json");
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const listener = vi.fn();
      window.addEventListener(AUTH_LOST_EVENT, listener);
      try {
        expect(await investigationGateway.queryInvestigations({}, options())).toEqual({
          ok: false,
          error: { kind: "auth_lost", status },
        });
        expect(json).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener(AUTH_LOST_EVENT, listener);
      }
    },
  );

  it("keeps an empty parsed page distinct from an unavailable query", async () => {
    const empty = collectionPageJson({ items: [], hiddenArchivedCount: 0 });
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(jsonResponse(empty));
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503));

    expect(await investigationGateway.queryInvestigations({}, options())).toEqual({
      ok: true,
      value: empty,
    });
    expect(await investigationGateway.queryInvestigations({}, options())).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503 },
    });
  });

  it("fails closed when a gateway double lacks the query seam", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const resolved = investigationCollectionQueryGateway(createInvestigationGatewayDouble());
    expect(await resolved.queryInvestigations({ q: "checkout" }, options())).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await investigationGateway.queryInvestigations({}, options(controller))).toEqual({
      ok: false,
      error: { kind: "aborted" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
