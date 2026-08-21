import { describe, expect, it } from "vitest";
import { hostImportFailure, type ImportOutcomeReport } from "./engine";

const rejectedOutcome: ImportOutcomeReport = {
  schemaId: "contextdesk.import_outcome.v1",
  schemaVersion: 1,
  class: "rejected",
  published: false,
  counts: {
    sourcesDiscovered: 1,
    sourcesImported: 0,
    sourcesFailed: 1,
    sourcesExcluded: 0,
    sourcesIgnored: 0,
    recordsImported: 0,
    recordsMalformed: 0,
  },
  defects: [
    {
      code: "archive_unreadable",
      severity: "fatal",
      source: {
        identity: "bundles/inner.zip",
        archiveChain: ["bundles"],
        member: "inner.zip",
        archiveDepth: 1,
      },
      occurrences: 1,
    },
  ],
  defectCounts: { archive_unreadable: 1 },
  privacy: {
    redactionMode: "identity_structural_only",
    policySummary: "structural identity only",
    defectsTruncated: false,
  },
  manifestDigest: "sha256:rejected",
};

describe("hostImportFailure", () => {
  it("reads a structured host object with a classified outcome", () => {
    expect(
      hostImportFailure({
        message: "zip open: missing end record",
        outcome: rejectedOutcome,
      }),
    ).toEqual({
      message: "zip open: missing end record",
      outcome: rejectedOutcome,
    });
  });

  it("reads a JSON-serialized host rejection", () => {
    expect(
      hostImportFailure(
        JSON.stringify({
          message: "zip open: missing end record",
          outcome: rejectedOutcome,
        }),
      ),
    ).toEqual({
      message: "zip open: missing end record",
      outcome: rejectedOutcome,
    });
  });

  it("keeps a plain host string as a message-only failure", () => {
    expect(hostImportFailure("disk full while staging")).toEqual({
      message: "disk full while staging",
    });
  });
});
