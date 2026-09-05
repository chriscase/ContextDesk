import {
  CASE_LIST_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  type CaseV1,
} from "@cd-collab/contracts/investigation-runtime";
import {
  investigationCollectionQueryGateway,
  investigationOperationsQueueGateway,
} from "../gateway.js";
import { describe, expect, it } from "vitest";
import {
  READ_ONLY_CAPABILITY_FIXTURE,
  RUNTIME_FIXTURE_IDS,
  RUNTIME_BULK_ANNOTATION_FIXTURE_IDS,
  VIEWER_CAPABILITY_FIXTURE,
  createAbortIgnoringDeferred,
  createInvestigationGatewayDouble,
  gatewayOk,
  gatewayUnavailable,
  makeArchiveAllowedLifecycle,
  makeArchiveRefusedLifecycle,
  makeArtifactAnnotationBulkRequest,
  makeArtifactAnnotationBulkResult,
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
  makeEvidenceUploadSuccess,
  makeOperationsQueuePage,
  makePopulatedCase,
  makeRestoreAllowedLifecycle,
  makeSparseImportedCase,
} from "./index.js";

describe("Runtime V1 deterministic testkit", () => {
  it("provides parser-normalized sparse and populated investigations", () => {
    const sparse = makeSparseImportedCase();
    const populated = makePopulatedCase();
    const list = makeCaseList();

    expect(sparse).toMatchObject({
      id: RUNTIME_FIXTURE_IDS.sparseCase,
      problemStatement: "",
      affectedParties: "",
      impact: "",
      scope: "",
      openQuestions: [],
      investigationContext: null,
      occurredAt: null,
    });
    expect(populated.investigationContext?.component).toBe("checkout-api");
    expect(list.schemaId).toBe(CASE_LIST_SCHEMA_ID);
    expect(list.cases.map(({ id }) => id)).toEqual([
      RUNTIME_FIXTURE_IDS.sparseCase,
      RUNTIME_FIXTURE_IDS.populatedCase,
    ]);
  });

  it("keeps evidence, upload, and contribution identities coherent", () => {
    const evidence = makeEvidenceList();
    const upload = makeEvidenceUploadSuccess();
    const contributions = makeContributionList();

    expect(evidence.schemaId).toBe(EVIDENCE_LIST_SCHEMA_ID);
    expect(upload.schemaId).toBe(EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID);
    expect(upload.artifact).toEqual(evidence.artifacts[0]);
    expect(upload.artifact.summaryContributionId).toBe(upload.summary.id);
    expect(contributions.contributions.map(({ id }) => id)).toContain(upload.summary.id);
  });

  it("provides a frozen queue page with coherent joined rows and server counts", () => {
    const page = makeOperationsQueuePage();
    expect(page.items.map((item) => item.investigation.id)).toEqual([
      RUNTIME_FIXTURE_IDS.populatedCase,
      RUNTIME_FIXTURE_IDS.sparseCase,
    ]);
    expect(page.items.map((item) => item.coordination.investigationId)).toEqual(
      page.items.map((item) => item.investigation.id),
    );
    expect(page.coordinationScopeCounts).toEqual({ allVisible: 2, mine: 1, unassigned: 1 });
    expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.items)).toBe(true);
    expect(Object.isFrozen(page.items[0]?.coordination.coordinator)).toBe(true);
    expect(Object.isFrozen(page.coordinationScopeCounts)).toBe(true);
  });

  it("provides contract-normalized bulk annotation fixtures with set identities", () => {
    const request = makeArtifactAnnotationBulkRequest();
    const result = makeArtifactAnnotationBulkResult();
    expect(request.artifactIds).toEqual([
      RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.firstArtifact,
      RUNTIME_BULK_ANNOTATION_FIXTURE_IDS.secondArtifact,
    ]);
    expect(result.items.map((item) => item.artifactId)).toEqual(request.artifactIds);
    expect(result.items.every((item) =>
      item.outcome === "not_found"
      || (item.annotation.caseId === result.caseId && item.annotation.artifactId === item.artifactId),
    )).toBe(true);
  });

  it("provides semantically valid allowed and refused lifecycle views", () => {
    const archiveAllowed = makeArchiveAllowedLifecycle();
    const archiveRefused = makeArchiveRefusedLifecycle();
    const restoreAllowed = makeRestoreAllowedLifecycle();

    expect(archiveAllowed.schemaId).toBe(INVESTIGATION_LIFECYCLE_SCHEMA_ID);
    expect(archiveAllowed.archive).toEqual({
      allowed: true,
      action: "archive",
      targetStatus: "archived",
    });
    expect(archiveRefused.archive).toMatchObject({
      allowed: false,
      action: "archive",
      reason: "legal_hold",
    });
    expect(restoreAllowed.restore).toEqual({
      allowed: true,
      action: "restore",
      targetStatus: "monitoring",
    });
    expect(restoreAllowed.deletion.supported).toBe(false);
  });

  it("distinguishes capability-limited viewers from static read-only builds", () => {
    expect(VIEWER_CAPABILITY_FIXTURE).toEqual({
      staticReadOnly: false,
      capabilities: ["investigation:read"],
    });
    expect(READ_ONLY_CAPABILITY_FIXTURE.staticReadOnly).toBe(true);
    expect(READ_ONLY_CAPABILITY_FIXTURE.capabilities).toContain("investigation:write");
    expect(READ_ONLY_CAPABILITY_FIXTURE.capabilities).toContain("run:strategies");
  });

  it("answers every gateway read from the fixtures and refuses unasked writes", async () => {
    const { signal } = new AbortController();
    const gateway = createInvestigationGatewayDouble();

    expect(gateway.queryInvestigations).toBeUndefined();
    expect(gateway.queryOperationsQueue).toBeUndefined();
    await expect(gateway.listInvestigations({ signal })).resolves.toEqual(
      gatewayOk(makeCaseList().cases),
    );
    await expect(
      gateway.getInvestigation(RUNTIME_FIXTURE_IDS.populatedCase, { signal }),
    ).resolves.toEqual(gatewayOk(makePopulatedCase()));
    await expect(
      gateway.getLifecycle(RUNTIME_FIXTURE_IDS.populatedCase, { signal }),
    ).resolves.toEqual(gatewayOk(makeArchiveAllowedLifecycle()));
    await expect(
      gateway.createInvestigation({ title: "never asked for" }, { signal }),
    ).resolves.toEqual({ ok: false, error: { kind: "unexpected" } });
    expect(gatewayUnavailable()).toEqual({
      ok: false,
      error: { kind: "unavailable", status: 503 },
    });
  });

  it("lets one named override replace a single gateway answer", async () => {
    const { signal } = new AbortController();
    const gateway = createInvestigationGatewayDouble({
      listInvestigations: async () => gatewayUnavailable<readonly CaseV1[]>(),
    });

    await expect(gateway.listInvestigations({ signal })).resolves.toEqual(gatewayUnavailable());
    await expect(
      gateway.listEvidence(RUNTIME_FIXTURE_IDS.populatedCase, { signal }),
    ).resolves.toEqual(gatewayOk(makeEvidenceList().artifacts));
  });

  it("fails the missing collection-query seam closed without inventing a page", async () => {
    const { signal } = new AbortController();
    const gateway = createInvestigationGatewayDouble();
    const resolved = investigationCollectionQueryGateway(gateway);

    await expect(resolved.queryInvestigations({ q: "checkout" }, { signal })).resolves.toEqual(
      gatewayUnavailable(),
    );
    await expect(gateway.listInvestigations({ signal })).resolves.toEqual(
      gatewayOk(makeCaseList().cases),
    );
  });

  it("fails the missing queue seam closed without using either collection read", async () => {
    const { signal } = new AbortController();
    const gateway = createInvestigationGatewayDouble();
    const resolved = investigationOperationsQueueGateway(gateway);

    await expect(resolved.queryOperationsQueue({ coordinationScope: "mine" }, { signal }))
      .resolves.toEqual(gatewayUnavailable());
    expect(gateway.queryInvestigations).toBeUndefined();
    expect(gateway.listInvestigations).not.toHaveBeenCalled();
  });

  it("models a late transport that ignores abort without using a clock", async () => {
    const controller = new AbortController();
    const delayed = createAbortIgnoringDeferred<string>(controller.signal);

    controller.abort();
    expect(delayed.wasAborted()).toBe(true);
    delayed.resolve("late case A");

    await expect(delayed.promise).resolves.toBe("late case A");
  });
});
