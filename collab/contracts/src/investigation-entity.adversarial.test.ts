/**
 * Adversarial pressure on the registry boundary.
 *
 * Each case here is a way the "global registry holds only reusable labels"
 * rule erodes in practice: content smuggled into a descriptor field, a label
 * that renders as something it is not, a citation that quietly becomes
 * evidence, or a human record relabelled as a model decision. These are
 * contract-level defences; the server and browser suites re-test the same
 * boundary through the routes and the UI.
 */
import { describe, expect, it } from "vitest";
import {
  ENTITY_PROFILE_MAX_LENGTH,
  ENTITY_REFERENCE_MAX_LENGTH,
  INVOLVEMENT_NOTE_MAX_LENGTH,
  normalizeEntityLabel,
  normalizeEntityProfile,
  normalizeInvolvementNote,
  parseInvestigationEntity,
  parseInvestigationInvolvement,
} from "./investigation-entity.js";
import {
  parseInvestigationReference,
  referenceLocator,
} from "./investigation-reference.js";
import { parseInvestigationResolution } from "./investigation-resolution.js";
import { normalizeOccurredAt } from "./temporal.js";

const SYNTHETIC_LOG = [
  "2019-06-04T02:11:07Z WARN pool exhausted after 30s",
  "2019-06-04T02:11:08Z WARN pool exhausted after 30s",
  "2019-06-04T02:11:09Z ERROR upstream deadline exceeded",
].join("\n");

const entity = () => ({
  schemaId: "cd-collab.investigation_entity.v1" as const,
  id: "8f1d0c2a-5b47-4d3e-9a10-6c2e7b4f0a91",
  kind: "system" as const,
  label: "Synthetic batch scheduler",
  profile: null,
  privacyClass: "owner_only" as const,
  lifecycle: "active" as const,
  createdAt: "2024-02-11T09:15:00.000Z",
  createdBy: "synthetic-operator",
  updatedAt: "2024-02-11T09:15:00.000Z",
});

const involvement = () => ({
  schemaId: "cd-collab.investigation_involvement.v1" as const,
  id: "0d9c8b7a-6543-4210-9fed-cba987654321",
  investigationId: "11111111-1111-4111-8111-111111111111",
  entityId: "8f1d0c2a-5b47-4d3e-9a10-6c2e7b4f0a91",
  relationship: "affected" as const,
  state: "active" as const,
  note: "",
  recordedLabel: "Synthetic batch scheduler",
  recordedKind: "system" as const,
  currentLabel: "Synthetic batch scheduler",
  currentKind: "system" as const,
  currentLifecycle: "active" as const,
  occurredAt: null,
  occurredAtPrecision: "unknown" as const,
  occurredAtZone: "unspecified" as const,
  recordedAt: "2024-02-11T09:20:00.000Z",
  recordedBy: "synthetic-operator",
  recordedByUsername: "synthetic-operator",
  releasedAt: null,
});

describe("the registry refuses to become a content store", () => {
  it("rejects a pasted log in a profile summary", () => {
    expect(() => normalizeEntityProfile({ summary: SYNTHETIC_LOG, reference: "" })).toThrow(
      /must be a single line/,
    );
    expect(() => normalizeInvolvementNote(SYNTHETIC_LOG)).toThrow(/must be a single line/);
  });

  it("rejects a single-line log longer than a descriptor", () => {
    const oneLine = "x".repeat(ENTITY_PROFILE_MAX_LENGTH + 1);
    expect(() => normalizeEntityProfile({ summary: oneLine, reference: "" })).toThrow(
      /investigation content belongs in the investigation/,
    );
    expect(() =>
      normalizeEntityProfile({ summary: "", reference: "y".repeat(ENTITY_REFERENCE_MAX_LENGTH + 1) }),
    ).toThrow(/investigation content belongs in the investigation/);
  });

  it("rejects an involvement note used as an evidence excerpt", () => {
    expect(() => normalizeInvolvementNote("z".repeat(INVOLVEMENT_NOTE_MAX_LENGTH + 1))).toThrow(
      /investigation content belongs in the investigation/,
    );
  });

  it("rejects extra profile keys that would carry contact or payload data", () => {
    for (const key of ["email", "phone", "attachment", "logExcerpt", "__proto__"]) {
      expect(() => normalizeEntityProfile({ summary: "ok", [key]: "value" })).toThrow(
        /unknown key/,
      );
    }
  });

  it("rejects an entity row that grows a sidecar field", () => {
    expect(() => parseInvestigationEntity({ ...entity(), evidenceIds: [] })).toThrow(/unknown key/);
    expect(() => parseInvestigationInvolvement({ ...involvement(), body: SYNTHETIC_LOG })).toThrow(
      /unknown key/,
    );
  });
});

describe("labels cannot render as something they are not", () => {
  it("rejects control characters, line breaks, and bidi overrides", () => {
    for (const label of [
      "Synthetic\nsecond line",
      "Synthetic\u0000null",
      "Synthetic\u001bescape",
      "Synthetic\u2028separator",
      "Synthetic\u202eoverride",
    ]) {
      expect(() => normalizeEntityLabel(label)).toThrow(/single line/);
    }
  });

  it("keeps a label a label, not a length-unbounded blob", () => {
    expect(() => normalizeEntityLabel("x".repeat(201))).toThrow(/exceeds 200/);
    expect(() => normalizeEntityLabel(42)).toThrow(/expected string/);
    expect(() => normalizeEntityLabel(null)).toThrow(/expected string/);
  });

  it("stores an ordinary label unchanged rather than rewriting it", () => {
    expect(normalizeEntityLabel("Fable Harbor (synthetic)")).toBe("Fable Harbor (synthetic)");
  });
});

describe("a citation cannot smuggle access or content", () => {
  const base = {
    schemaId: "cd-collab.investigation_reference.v1" as const,
    id: "5c4b3a29-1807-4f6e-bd5c-4a3b2c1d0e9f",
    fromInvestigationId: "22222222-2222-4222-8222-222222222222",
    toInvestigationId: "11111111-1111-4111-8111-111111111111",
    resourceKind: "investigation" as const,
    resourceId: "11111111-1111-4111-8111-111111111111",
    locator: referenceLocator(
      "11111111-1111-4111-8111-111111111111",
      "investigation",
      "11111111-1111-4111-8111-111111111111",
    ),
    note: "",
    recordedTitle: "Synthetic prior investigation",
    currentTitle: null,
    visibility: "restricted" as const,
    state: "active" as const,
    occurredAt: null,
    occurredAtPrecision: "unknown" as const,
    occurredAtZone: "unspecified" as const,
    recordedAt: "2024-02-11T09:25:00.000Z",
    recordedBy: "synthetic-operator",
    recordedByUsername: "synthetic-operator",
    withdrawnAt: null,
  };

  it("refuses a restricted citation that discloses the live title", () => {
    expect(() =>
      parseInvestigationReference({ ...base, currentTitle: "Synthetic prior investigation" }),
    ).toThrow(/must not disclose/);
  });

  it("refuses a locator pointed at a different investigation than the citation", () => {
    expect(() =>
      parseInvestigationReference({
        ...base,
        locator: referenceLocator(
          "33333333-3333-4333-8333-333333333333",
          "investigation",
          "33333333-3333-4333-8333-333333333333",
        ),
      }),
    ).toThrow(/must match the derived resource destination/);
  });

  it("refuses a locator carrying an absolute URL or a traversal", () => {
    for (const locator of [
      "//evil.invalid/investigations/11111111-1111-4111-8111-111111111111/situation",
      "/investigations/11111111-1111-4111-8111-111111111111/../../admin",
      "javascript:alert(1)",
    ]) {
      expect(() => parseInvestigationReference({ ...base, locator })).toThrow();
    }
  });

  it("refuses a citation that grows an evidence or support field", () => {
    for (const key of ["supportsHypothesis", "artifactId", "content", "excerpt"]) {
      expect(() => parseInvestigationReference({ ...base, [key]: "x" })).toThrow(/unknown key/);
    }
  });
});

describe("a human record cannot be relabelled as a model decision", () => {
  const resolution = {
    schemaId: "cd-collab.investigation_resolution.v1" as const,
    id: "7e6d5c4b-3a29-4180-bf7e-6c5d4e3f2a1b",
    investigationId: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    predecessorRevision: null,
    basis: "human_only" as const,
    provenance: "human" as const,
    status: "resolved" as const,
    rationale: "Reasoned from the two recorded observations.",
    unknowns: [],
    experimentDecisionId: null,
    exceptionReason: null,
    citedArtifactIds: [],
    citedContributionIds: [],
    occurredAt: null,
    occurredAtPrecision: "unknown" as const,
    occurredAtZone: "unspecified" as const,
    recordedAt: "2026-08-25T14:02:00.000Z",
    recordedBy: "synthetic-operator",
    recordedByUsername: "synthetic-operator",
    supersededAt: null,
  };

  it("refuses human_only reasoning dressed as an experiment outcome", () => {
    expect(() =>
      parseInvestigationResolution({
        ...resolution,
        experimentDecisionId: "3d2c1b0a-9887-4766-a554-433221100fee",
      }),
    ).toThrow(/must not cite an experiment decision/);
    expect(() =>
      parseInvestigationResolution({ ...resolution, provenance: "ai_generated" }),
    ).toThrow(/cannot claim ai_generated/);
  });

  it("refuses an empty rationale disguised as whitespace or control characters", () => {
    expect(() => parseInvestigationResolution({ ...resolution, rationale: "   " })).toThrow();
    expect(() =>
      parseInvestigationResolution({ ...resolution, rationale: "closed\u0007" }),
    ).toThrow(/control characters/);
  });

  it("refuses a resolution that silently rewrites its own audit clock", () => {
    expect(() =>
      parseInvestigationResolution({ ...resolution, recordedAt: "2026-08-25" }),
    ).toThrow(/full ISO-8601 instant/);
  });
});

describe("occurrence input cannot invent a clock", () => {
  it("refuses text that looks like a date but is not one", () => {
    for (const bad of ["2024-02-30", "2024-11-04T25:00", "2024-11-04T09:30:00+25:00"]) {
      expect(() => normalizeOccurredAt({ occurredAt: bad })).toThrow();
    }
  });

  it("never promotes a zone-unspecified value into an instant", () => {
    const normalized = normalizeOccurredAt({ occurredAt: "2024-11-04" });
    expect(normalized.occurredAt).toBe("2024-11-04");
    expect(normalized.occurredAtZone).toBe("unspecified");
  });

  it("refuses an occurrence dated after the recording clock it claims", () => {
    expect(() =>
      normalizeOccurredAt({ occurredAt: "2030-01-01" }, { now: "2026-05-01T12:00:00.000Z" }),
    ).toThrow(/must not be in the future/);
  });
});
