import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_STRATEGY_ID,
  UI_STRATEGIES,
  resolveUiStrategy,
  type UiStrategyId,
} from "./ui-strategy.js";

describe("UI strategy catalogue", () => {
  it("ships exactly the reference strategy and the first alternate", () => {
    expect(UI_STRATEGIES.map((strategy) => strategy.id)).toEqual([
      "war-room",
      "investigation-first",
    ] satisfies readonly UiStrategyId[]);

    for (const strategy of UI_STRATEGIES) {
      expect(strategy.name).toBeTruthy();
      expect(strategy.description).toBeTruthy();
      expect(strategy.previewToken).toBeTruthy();
      expect(strategy.compatibility.schemaId).toBe("cd-collab.case.v1");
      expect(strategy.compatibility.version).toMatch(/^\^\d+\.\d+\.\d+$/);
    }
  });
});

describe("resolveUiStrategy", () => {
  it("uses the reference strategy when no preference or policy exists", () => {
    expect(resolveUiStrategy().id).toBe(DEFAULT_UI_STRATEGY_ID);
  });

  it("prefers a valid user preference", () => {
    expect(resolveUiStrategy({ preferred: "investigation-first" }).id).toBe(
      "investigation-first",
    );
  });

  it("uses the instance default after an invalid preference", () => {
    expect(
      resolveUiStrategy({ preferred: "not-shipped", instanceDefault: "investigation-first" }).id,
    ).toBe("investigation-first");
  });

  it("does not let a preference bypass an allow-list", () => {
    expect(
      resolveUiStrategy({
        preferred: "investigation-first",
        instanceDefault: "war-room",
        allowedIds: ["war-room"],
      }).id,
    ).toBe("war-room");
  });

  it("chooses the first approved known strategy when the reference is not approved", () => {
    expect(
      resolveUiStrategy({ preferred: "unknown", allowedIds: ["investigation-first"] }).id,
    ).toBe("investigation-first");
  });

  it("fails closed for malformed or empty policy input", () => {
    expect(resolveUiStrategy({ preferred: {}, instanceDefault: 42, allowedIds: ["future"] }).id).toBe(
      DEFAULT_UI_STRATEGY_ID,
    );
    expect(resolveUiStrategy({ allowedIds: [] }).id).toBe(DEFAULT_UI_STRATEGY_ID);
  });
});

