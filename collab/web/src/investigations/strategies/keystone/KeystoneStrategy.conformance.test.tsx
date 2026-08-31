import { describe, expect, it } from "vitest";
import {
  COMPONENT_SURFACE_REQUIREMENT_IDS,
  runComponentConformance,
} from "../testkit/conformance.js";
import { KeystoneStrategy } from "./KeystoneStrategy.js";

describe("Keystone K2 shared component conformance", () => {
  it("meets every strategy-neutral Runtime V1 component requirement", async () => {
    const report = await runComponentConformance({
      label: "Keystone K2",
      component: KeystoneStrategy,
      controls: {
        openRecord: (title) => new RegExp(title.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        back: /^Back to investigations$/u,
        retryInvestigations: /^Retry loading investigations$/u,
      },
    });

    expect(report.evaluated.map(({ id }) => id)).toEqual(COMPONENT_SURFACE_REQUIREMENT_IDS);
  });
});
