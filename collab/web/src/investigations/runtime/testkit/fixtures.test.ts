import {
  CASE_LIST_SCHEMA_ID,
  EVIDENCE_LIST_SCHEMA_ID,
  EVIDENCE_UPLOAD_SUCCESS_SCHEMA_ID,
  INVESTIGATION_LIFECYCLE_SCHEMA_ID,
  type CaseV1,
} from "@cd-collab/contracts/investigation-runtime";
import { describe, expect, it } from "vitest";
import {
  READ_ONLY_CAPABILITY_FIXTURE,
  RUNTIME_FIXTURE_IDS,
  VIEWER_CAPABILITY_FIXTURE,
  createAbortIgnoringDeferred,
  createInvestigationGatewayDouble,
  gatewayOk,
  gatewayUnavailable,
  makeArchiveAllowedLifecycle,
  makeArchiveRefusedLifecycle,
  makeCaseList,
  makeContributionList,
  makeEvidenceList,
  makeEvidenceUploadSuccess,
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

  it("models a late transport that ignores abort without using a clock", async () => {
    const controller = new AbortController();
    const delayed = createAbortIgnoringDeferred<string>(controller.signal);

    controller.abort();
    expect(delayed.wasAborted()).toBe(true);
    delayed.resolve("late case A");

    await expect(delayed.promise).resolves.toBe("late case A");
  });
});
