import { describe, expect, it } from "vitest";
import { parseCase } from "./case.js";

const baseCase = {
  schemaId: "cd-collab.case.v1",
  id: "case-synthetic-1",
  title: "Synthetic checkout investigation",
  severity: "medium",
  status: "open",
  legalHold: false,
  retentionClass: "standard",
  participants: [],
  createdAt: "2026-08-26T00:00:00.000Z",
  createdBy: "synthetic-alice",
};

describe("case investigation context", () => {
  it("preserves display values and defaults omitted context to null", () => {
    const parsed = parseCase({
      ...baseCase,
      investigationContext: {
        productName: "  Fixture Desk  ",
        version: "4.2",
        build: "build-007",
        component: "queue-worker",
        environment: "QA / us-central",
        organization: "Synthetic Harbor",
      },
    });

    expect(parsed.investigationContext).toEqual({
      productName: "  Fixture Desk  ",
      version: "4.2",
      build: "build-007",
      component: "queue-worker",
      environment: "QA / us-central",
      organization: "Synthetic Harbor",
    });
    expect(parseCase(baseCase).investigationContext).toBeNull();
  });

  it("rejects unknown fields and multiline metadata", () => {
    expect(() => parseCase({
      ...baseCase,
      investigationContext: { productName: "Fixture", tags: ["later"] },
    })).toThrow(/unknown key/);
    expect(() => parseCase({
      ...baseCase,
      investigationContext: { environment: "QA\nwith hidden line" },
    })).toThrow(/single line/);
  });
});
