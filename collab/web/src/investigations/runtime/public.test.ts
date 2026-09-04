import { describe, expect, it } from "vitest";
import type { InvestigationRuntimeProviderProps } from "./public.js";
import type {
  ArtifactAnnotationBulkResultV1,
  InvestigationCoordinationActionCommand,
  InvestigationArtifactAnnotationsBulkCommand,
  InvestigationRuntime,
} from "./public.js";
import { MAX_ARTIFACT_ANNOTATION_BULK_IDS } from "./public.js";
import * as publicRuntime from "./public.js";

const STRATEGY_FACING_PROPS: InvestigationRuntimeProviderProps = {
  identityKey: "alice",
  authorityKey: "alice-authority-v1",
  capabilities: ["investigation:read"],
  readOnly: false,
  active: true,
  focusCaseId: null,
  isInvestigationLocation: true,
  onOpenCreated: () => undefined,
  children: null,
};

describe("investigation runtime public surface", () => {
  it("does not expose transport or protected-fetch internals at runtime", () => {
    expect(Object.keys(publicRuntime).sort()).toEqual([
      "InvestigationRuntimeProvider",
      "MAX_ARTIFACT_ANNOTATION_BULK_IDS",
      "MAX_EVIDENCE_UPLOAD_BYTES",
      "selectEvidenceInventory",
      "selectResourceView",
      "useInvestigationRuntime",
    ]);
  });

  it("gives strategies no transport-injection seam on the provider contract", () => {
    // The guard here is the type error itself: typecheck fails if a `gateway`
    // prop ever returns to the strategy-facing contract. Transport reaches the
    // provider only through the runtime's internal test harness.
    // @ts-expect-error Runtime V1 accepts no transport from a strategy.
    const smuggled: InvestigationRuntimeProviderProps = { ...STRATEGY_FACING_PROPS, gateway: {} };
    expect(smuggled.capabilities).toEqual(["investigation:read"]);
  });

  it("exposes typed annotation and coordination commands only through the public seam", () => {
    const command: InvestigationArtifactAnnotationsBulkCommand = {
      artifactIds: ["evidence-a", "evidence-b"],
      body: "A shared observation.",
      idempotencyKey: "bulk-runtime-0001",
    };
    const result: ArtifactAnnotationBulkResultV1 | null = null;
    const runtime: Pick<InvestigationRuntime, "commands"> = {
      commands: {
        createInvestigation: null,
        uploadEvidence: null,
        createContribution: null,
        updateSituation: null,
        applyLifecycle: null,
        applyCoordinationAction: null,
        createArtifactAnnotation: null,
        createArtifactAnnotations: null,
      },
    };
    expect(command.artifactIds).toHaveLength(2);
    expect(MAX_ARTIFACT_ANNOTATION_BULK_IDS).toBe(64);
    expect(publicRuntime.MAX_ARTIFACT_ANNOTATION_BULK_IDS).toBe(64);
    expect(result).toBeNull();
    expect(runtime.commands.createArtifactAnnotations).toBeNull();
    const coordinationCommand: InvestigationCoordinationActionCommand = {
      action: "claim_self",
      idempotencyKey: "coord-public-0001",
    };
    expect(coordinationCommand.action).toBe("claim_self");
    const participantCommand: InvestigationCoordinationActionCommand = {
      action: "assign_participant",
      targetIdentityId: "identity-bob",
      idempotencyKey: "coord-public-0002",
    };
    expect(participantCommand.targetIdentityId).toBe("identity-bob");
    // @ts-expect-error Self actions must never carry a participant target.
    const invalidSelf: InvestigationCoordinationActionCommand = {
      action: "release_self",
      targetIdentityId: "identity-bob",
      idempotencyKey: "coord-public-0003",
    };
    // @ts-expect-error Participant actions require an explicit target.
    const invalidParticipant: InvestigationCoordinationActionCommand = {
      action: "release_participant",
      idempotencyKey: "coord-public-0004",
    };
    expect([invalidSelf.action, invalidParticipant.action]).toHaveLength(2);
  });
});
